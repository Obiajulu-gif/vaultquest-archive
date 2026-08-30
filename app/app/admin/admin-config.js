export const ADMIN_ADDRESSES = (process.env.NEXT_PUBLIC_ADMIN_ADDRESSES || "")
  .split(",")
  .map((addr) => addr.trim())
  .filter(Boolean);
