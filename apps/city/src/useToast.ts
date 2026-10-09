import { useEffect, useState } from "react";

// A message that clears itself after a few seconds.
export function useToast<T>(ms = 4000) {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (value === null) return;
    const id = setTimeout(() => setValue(null), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return [value, setValue] as const;
}
