import { useAppSelector } from '../store';
import BufferEditor from './editors/BufferEditor';
import ShaderEditor from './editors/ShaderEditor';
import PipelineEditor from './editors/PipelineEditor';
import VisualizerEditor from './editors/VisualizerEditor';

export default function EntityEditor() {
  const selectedId = useAppSelector(state => state.ui.selectedEntityId);
  const entities = useAppSelector(state => state.project.entities);
  const openEntities = useAppSelector(state => state.ui.openEntities);

  if (!selectedId) {
    return (
      <div className="entity-editor empty">
        <span>Open a project and select an entity.</span>
      </div>
    );
  }

  const ref = entities.find(e => e.id === selectedId);
  const data = openEntities[selectedId];

  if (!ref || !data) return null;

  switch (ref.type) {
    case 'buffer':     return <BufferEditor id={selectedId} />;
    case 'shader':     return <ShaderEditor id={selectedId} />;
    case 'pipeline':   return <PipelineEditor key={selectedId} id={selectedId} />;
    case 'visualizer': return <VisualizerEditor key={selectedId} id={selectedId} />;
  }
}
