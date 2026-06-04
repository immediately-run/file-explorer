// Root component — immediately.run renders the default export of THIS file.
// Global CSS is imported here (not main.tsx). A read-only system app: a tree
// view of the mounts (spaces / granted subtrees) shared with this app.
import "./index.css";
import "./App.css";
import FileExplorer from "./components/FileExplorer";

function App() {
  return <FileExplorer />;
}

export default App;
