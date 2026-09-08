/** @param {number} total @param {number} requestedPage */
export function jobPagination(total, requestedPage) {
  const size = 25;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage) || 1));
  const start = (page - 1) * size;
  const firstNearby = Math.max(1, Math.min(page - 1, totalPages - 2));
  const lastNearby = Math.min(totalPages, Math.max(page + 1, 3));
  const included = new Set([1, totalPages]);
  for (let value = firstNearby; value <= lastNearby; value++) included.add(value);
  /** @type {(number | string)[]} */
  const numbers = [];
  let previous = 0;
  for (const value of [...included].sort((a, b) => a - b)) {
    if (value - previous === 2) numbers.push(previous + 1);
    else if (value - previous > 2) numbers.push(`gap-${previous + 1}`);
    numbers.push(value);
    previous = value;
  }
  return { page, totalPages, start, end: Math.min(start + size, total), numbers };
}
