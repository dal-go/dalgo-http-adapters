// Vite's `?raw` suffix imports a file's text (used by the read-only static check).
declare module "*?raw" {
  const text: string;
  export default text;
}
