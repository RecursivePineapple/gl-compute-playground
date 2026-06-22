import { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { entityAdded } from '../store/projectSlice';
import { entitySelected, entityLoaded } from '../store/uiSlice';
import { invoke } from '../ipc/client';
import { EntityData, EntityRef, EntityType } from '../../shared/types';

const SECTIONS: { type: EntityType; label: string }[] = [
  { type: 'buffer',     label: 'Buffers' },
  { type: 'shader',     label: 'Shaders' },
  { type: 'pipeline',   label: 'Pipelines' },
  { type: 'visualizer', label: 'Visualizers' }
];

export default function ProjectTree() {
  const dispatch = useAppDispatch();
  const projectOpen = useAppSelector(state => state.project.path !== null);
  const entities = useAppSelector(state => state.project.entities);
  const selectedId = useAppSelector(state => state.ui.selectedEntityId);

  const [creatingType, setCreatingType] = useState<EntityType | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function selectEntity(ref: EntityRef) {
    const data = await invoke<EntityData>('entity:load', { filePath: ref.filePath });
    dispatch(entityLoaded({ id: ref.id, data }));
    dispatch(entitySelected(ref.id));
  }

  function startCreating(type: EntityType) {
    setCreatingType(type);
    setCreateError(null);
    // Focus happens via autoFocus on the input
  }

  function cancelCreating() {
    setCreatingType(null);
    setCreateError(null);
  }

  async function submitCreate(name: string) {
    const trimmed = name.trim();
    if (!trimmed) { cancelCreating(); return; }

    try {
      const ref = await invoke<EntityRef>('entity:create', { type: creatingType, name: trimmed });
      const data = await invoke<EntityData>('entity:load', { filePath: ref.filePath });
      dispatch(entityAdded(ref));
      dispatch(entityLoaded({ id: ref.id, data }));
      dispatch(entitySelected(ref.id));
      cancelCreating();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      inputRef.current?.select();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter')  submitCreate(e.currentTarget.value);
    if (e.key === 'Escape') cancelCreating();
  }

  return (
    <div className="project-tree">
      {SECTIONS.map(({ type, label }) => (
        <div key={type} className="tree-section">
          <div className="tree-section-header">
            <span>{label}</span>
            {projectOpen && (
              <button
                className="tree-add-btn"
                title={`New ${label.slice(0, -1)}`}
                onClick={() => startCreating(type)}
              >+</button>
            )}
          </div>

          {entities
            .filter(e => e.type === type)
            .map(ref => (
              <div
                key={ref.id}
                className={`tree-item${selectedId === ref.id ? ' selected' : ''}`}
                onClick={() => selectEntity(ref)}
              >
                {ref.name}
              </div>
            ))}

          {creatingType === type && (
            <div className="tree-create">
              <input
                ref={inputRef}
                type="text"
                className="tree-create-input"
                placeholder="name"
                autoFocus
                onKeyDown={onKeyDown}
                onBlur={e => submitCreate(e.target.value)}
              />
              {createError && <div className="tree-create-error">{createError}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
