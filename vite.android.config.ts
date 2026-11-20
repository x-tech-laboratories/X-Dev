import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The phone's page calls a daemon on another computer, which the browser page's policy forbids.
const android_content_policy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: http:";

function set_content_policy(): Plugin {
  return {
    name: "x-dev-android-content-policy",
    transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy" content=")[^"]*/, `$1${android_content_policy}`),
  };
}

// The page for the Capacitor app, built with mode "android" so it works on a daemon it connects to.
export default defineConfig({
  root: "src/web",
  base: "./",
  mode: "android",
  plugins: [react(), set_content_policy()],
  build: { outDir: "../../out/android", emptyOutDir: true },
});
