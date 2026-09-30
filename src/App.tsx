// Root component — immediately.run renders the default export of THIS file.
// Global CSS is imported here (not main.tsx). The shipped app is now assembled
// entirely from the headless library + its SDK adapter (`<SdkFileExplorer/>`) —
// the parity proof for the file-explorer-library extraction.
import "./index.css";
import "./lib-ui/styles.css";
import SdkFileExplorer from "./lib-ui/sdk";
import { useHostThemeAttribute } from "./hooks/useHostThemeAttribute";

function App() {
  // R3-827 — drive `html[data-theme]` from the host's polarity so the light
  // palette (index.css) actually applies when the host goes light.
  useHostThemeAttribute();
  return <SdkFileExplorer />;
}

export default App;
