import { useState, useRef, useEffect } from 'react';
import { useAppDispatch } from '../store';
import { projectOpened } from '../store/projectSlice';
import { invoke } from '../ipc/client';
import { EntityRef } from '../../shared/types';

export default function Header() {
  const dispatch = useAppDispatch();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  async function openProject() {
    setMenuOpen(false);
    const result = await invoke<{ path: string; entities: EntityRef[] } | null>('project:open');
    if (result) dispatch(projectOpened(result));
  }

  return (
    <div className="header">
      <div className="menu-root" ref={menuRef}>
        <button onClick={() => setMenuOpen(v => !v)}>File</button>
        {menuOpen && (
          <div className="menu-dropdown">
            <button onClick={openProject}>Open Project</button>
          </div>
        )}
      </div>
    </div>
  );
}
