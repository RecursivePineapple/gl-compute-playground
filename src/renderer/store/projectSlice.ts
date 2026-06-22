import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { EntityRef } from '../../shared/types';

interface ProjectState {
  path: string | null;
  entities: EntityRef[];
}

const initialState: ProjectState = {
  path: null,
  entities: []
};

const projectSlice = createSlice({
  name: 'project',
  initialState,
  reducers: {
    projectOpened(state, action: PayloadAction<{ path: string; entities: EntityRef[] }>) {
      state.path = action.payload.path;
      state.entities = action.payload.entities;
    },

    entityAdded(state, action: PayloadAction<EntityRef>) {
      state.entities.push(action.payload);
    },

    projectClosed(state) {
      state.path = null;
      state.entities = [];
    }
  }
});

export const { projectOpened, entityAdded, projectClosed } = projectSlice.actions;
export default projectSlice.reducer;
