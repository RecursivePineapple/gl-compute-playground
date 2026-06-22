import { ipcMain, dialog } from 'electron';
import { scanProject, saveEntity, loadEntity, createEntity } from '../project/io';
import { compileShader } from '../gl/compiler';
import { executePipeline } from '../gl/executor';
import { EntityRef, EntityType, PipelineData } from '../../shared/types';

let projectState: { path: string; entities: EntityRef[] } | null = null;

export function registerHandlers(): void {
  ipcMain.handle('project:open', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;

    const projectPath = result.filePaths[0];
    const entities = scanProject(projectPath);
    projectState = { path: projectPath, entities };
    return { path: projectPath, entities };
  });

  ipcMain.handle('entity:save', (_event, { filePath, data }: { filePath: string; data: object }) => {
    saveEntity(filePath, data);
  });

  ipcMain.handle('entity:load', (_event, { filePath }: { filePath: string }) => {
    return loadEntity(filePath);
  });

  ipcMain.handle('dialog:openFile', async (_event, { filters }: { filters?: Electron.FileFilter[] }) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: filters ?? []
    });
    return { filePath: result.canceled ? null : result.filePaths[0] };
  });

  ipcMain.handle('entity:create', (_event, { type, name }: { type: EntityType; name: string }) => {
    if (!projectState) throw new Error('No project open.');
    const ref = createEntity(projectState.path, type, name);
    projectState.entities.push(ref);
    return ref;
  });

  ipcMain.handle('shader:compile', (_event, { source }: { source: string }) => {
    return compileShader(source);
  });

  ipcMain.handle('pipeline:execute', async (_event, { pipeline }: { pipeline: PipelineData }) => {
    if (!projectState) return { bufferResults: {}, errors: ['No project open.'] };
    return executePipeline(pipeline, projectState.path, projectState.entities);
  });
}
