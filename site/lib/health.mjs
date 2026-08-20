export async function isStorageHealthy(db) {
  try {
    const result = await db.prepare("SELECT 1 AS ok").first();
    return result?.ok === 1;
  } catch {
    return false;
  }
}
