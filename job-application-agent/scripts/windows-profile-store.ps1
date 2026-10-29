$ErrorActionPreference = 'Stop'

# Profile store helper for secret-store.mjs on Windows. It reads one JSON request
# line ({op, service, account, path}) plus the plaintext from stdin.
#
# Requests are validated before any credential or file access:
#   - op must be 'set' or 'get';
#   - service must be the fixed job-application-agent service name, or a
#     sub-name of it ('com.vaibhavarora.job-application-agent.<suffix>');
#   - account is a short identifier;
#   - path must resolve inside the state folder (JOB_APPLICATION_AGENT_STATE_DIR,
#     otherwise %APPDATA%\job-application-agent), end in .dat, and not pass through
#     a junction or symlink below that folder.
#
# Why Add-Type stays: the profile file itself is already sealed with the built-in
# [System.Security.Cryptography.ProtectedData] (DPAPI, CurrentUser). The AES
# wrapping key lives in Windows Credential Manager, and Windows PowerShell 5.1 has
# no built-in cmdlet or .NET type for Credential Manager generic credentials, so
# CredRead/CredWrite need this small P/Invoke declaration. Dropping it would mean
# moving the key out of Credential Manager, a storage-format migration that still
# needs CredRead to read existing keys.
$SecretServicePrefix = 'com.vaibhavarora.job-application-agent'

function Reject([string]$Reason) {
  throw (New-Object System.InvalidOperationException ('rejected: ' + $Reason))
}

function Get-StateRoot {
  $root = $env:JOB_APPLICATION_AGENT_STATE_DIR
  if (-not $root) {
    $appData = $env:APPDATA
    if (-not $appData) { $appData = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'AppData\Roaming' }
    $root = Join-Path $appData 'job-application-agent'
  }
  if (-not [IO.Path]::IsPathRooted($root)) { Reject 'state folder is not an absolute path' }
  return [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-Service([string]$Service) {
  if (-not $Service -or $Service.Length -gt 200 -or $Service -notmatch '^[A-Za-z0-9._-]+$') { Reject 'service name is invalid' }
  if (-not ($Service -ceq $SecretServicePrefix -or $Service.StartsWith($SecretServicePrefix + '.', [StringComparison]::Ordinal))) {
    Reject 'service name lacks the job-application-agent prefix'
  }
}

function Assert-Account([string]$Account) {
  if (-not $Account -or $Account.Length -gt 64 -or $Account -notmatch '^[A-Za-z0-9._-]+$') { Reject 'account name is invalid' }
}

function Resolve-ProfilePath([string]$Path) {
  if (-not $Path -or -not [IO.Path]::IsPathRooted($Path)) { Reject 'profile path is not absolute' }
  $root = Get-StateRoot
  $full = [IO.Path]::GetFullPath($Path)
  $sep = [string][IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($root + $sep, [StringComparison]::OrdinalIgnoreCase)) { Reject 'profile path is outside the state folder' }
  if ([IO.Path]::GetExtension($full) -ne '.dat') { Reject 'profile path must be a .dat file' }
  # No junctions or symlinks between the state folder and the file.
  $current = $full
  while ($current.Length -gt $root.Length) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Reject 'profile path passes through a link' }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
  return $full
}

Add-Type -AssemblyName System.Security

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class JobAppCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credentialPtr);
}
"@

function Read-Request {
  $stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  $metaLine = $stdin.ReadLine()
  if (-not $metaLine) { throw 'Missing profile-store request.' }
  $meta = $metaLine | ConvertFrom-Json
  $plaintext = $stdin.ReadToEnd()
  return @{ Meta = $meta; Plaintext = $plaintext }
}

function Get-WrappingKey([string]$Target, [string]$UserName, [bool]$Create) {
  $ptr = [IntPtr]::Zero
  if ([JobAppCred]::CredRead($Target, 1, 0, [ref]$ptr)) {
    try {
      $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][JobAppCred+CREDENTIAL])
      $bytes = New-Object byte[] $cred.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
      return $bytes
    } finally {
      [JobAppCred]::CredFree($ptr)
    }
  }
  if (-not $Create) { return $null }
  $key = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
  $blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($key.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($key, 0, $blobPtr, $key.Length)
    $cred = New-Object JobAppCred+CREDENTIAL
    $cred.Type = 1
    $cred.TargetName = $Target
    $cred.UserName = $UserName
    $cred.CredentialBlob = $blobPtr
    $cred.CredentialBlobSize = [uint32]$key.Length
    $cred.Persist = 2
    if (-not [JobAppCred]::CredWrite([ref]$cred, 0)) {
      throw 'write-failed'
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
  }
  return $key
}

function Protect-Profile([byte[]]$Key, [string]$Plaintext, [string]$Path) {
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($Plaintext)
  $aes = [Security.Cryptography.Aes]::Create()
  try {
    $aes.Key = $Key
    $aes.GenerateIV()
    $encryptor = $aes.CreateEncryptor()
    $cipher = $encryptor.TransformFinalBlock($plainBytes, 0, $plainBytes.Length)
    $payload = New-Object byte[] ($aes.IV.Length + $cipher.Length)
    [Array]::Copy($aes.IV, 0, $payload, 0, $aes.IV.Length)
    [Array]::Copy($cipher, 0, $payload, $aes.IV.Length, $cipher.Length)
    $protected = [Security.Cryptography.ProtectedData]::Protect($payload, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    [IO.File]::WriteAllBytes($Path, $protected)
  } finally {
    $aes.Dispose()
  }
}

function Unprotect-Profile([byte[]]$Key, [string]$Path) {
  $protected = [IO.File]::ReadAllBytes($Path)
  $payload = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $aes = [Security.Cryptography.Aes]::Create()
  try {
    $aes.Key = $Key
    $iv = New-Object byte[] $aes.IV.Length
    [Array]::Copy($payload, 0, $iv, 0, $iv.Length)
    $aes.IV = $iv
    $cipher = New-Object byte[] ($payload.Length - $iv.Length)
    [Array]::Copy($payload, $iv.Length, $cipher, 0, $cipher.Length)
    $decryptor = $aes.CreateDecryptor()
    $plainBytes = $decryptor.TransformFinalBlock($cipher, 0, $cipher.Length)
    return [Text.Encoding]::UTF8.GetString($plainBytes)
  } finally {
    $aes.Dispose()
  }
}

try {
  $request = Read-Request
  $meta = $request.Meta
  $op = [string]$meta.op
  if ($op -cne 'set' -and $op -cne 'get') { Reject 'unsupported operation' }
  $target = [string]$meta.service
  $account = [string]$meta.account
  Assert-Service $target
  Assert-Account $account
  $path = Resolve-ProfilePath ([string]$meta.path)
  if ($op -eq 'set') {
    $key = Get-WrappingKey $target $account $true
    Protect-Profile $key $request.Plaintext $path
  } elseif ($meta.op -eq 'get') {
    $key = Get-WrappingKey $target $account $false
    if (-not $key -or -not (Test-Path -LiteralPath $path)) { throw 'missing' }
    $text = Unprotect-Profile $key $path
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8
    [Console]::Out.Write($text)
  } else {
    throw 'unsupported'
  }
} catch {
  $message = [string]$_.Exception.Message
  if ($message.StartsWith('rejected: ')) {
    [Console]::Error.WriteLine('Windows profile storage rejected the request: ' + $message.Substring(10) + '.')
  } else {
    [Console]::Error.WriteLine('Windows profile storage failed.')
  }
  exit 1
}
