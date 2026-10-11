// Poll the latest loader and discard replies overtaken by another request or
// by navigation. The loader is read at request time, never captured at mount.
export function messageFeed<T>(load: () => Promise<T>, receive: (value: T) => void, fail: (error: unknown) => void) {
  let generation = 0;
  let active = true;
  return {
    async refresh() {
      const mine = ++generation;
      try {
        const value = await load();
        if (active && mine === generation) receive(value);
      } catch (e) {
        if (active && mine === generation) fail(e);
      }
    },
    close() { active = false; generation++; },
  };
}
