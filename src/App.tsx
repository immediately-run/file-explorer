// Root component — immediately.run renders the default export of THIS file.
// Global CSS is imported here (not main.tsx). The shipped app is now assembled
// entirely from the headless library + its SDK adapter (`<SdkFileExplorer/>`) —
// the parity proof for the file-explorer-library extraction.
import "./index.css";
import "./lib-ui/styles.css";
import SdkFileExplorer from "./lib-ui/sdk";

function App() {
  return <SdkFileExplorer />;
}

export default App;
