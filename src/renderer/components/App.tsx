import Header from './Header';
import ProjectTree from './ProjectTree';
import EntityEditor from './EntityEditor';

export default function App() {
  return (
    <div className="app">
      <Header />
      <div className="workspace">
        <ProjectTree />
        <EntityEditor />
      </div>
    </div>
  );
}
