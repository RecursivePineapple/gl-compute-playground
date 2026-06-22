import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { EntityData } from '../../shared/types';

interface UIState {
  selectedEntityId: string | null;
  openEntities: Record<string, EntityData>;
  executionResults: Record<string, number[]> | null;
}

const initialState: UIState = {
  selectedEntityId: null,
  openEntities: {},
  executionResults: null
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    entitySelected(state, action: PayloadAction<string | null>) {
      state.selectedEntityId = action.payload;
    },

    entityLoaded(state, action: PayloadAction<{ id: string; data: EntityData }>) {
      state.openEntities[action.payload.id] = action.payload.data;
    },

    entityUpdated(state, action: PayloadAction<{ id: string; data: EntityData }>) {
      state.openEntities[action.payload.id] = action.payload.data;
    },

    executionStarted(state) {
      state.executionResults = null;
    },

    executionCompleted(state, action: PayloadAction<Record<string, number[]>>) {
      state.executionResults = action.payload;
    }
  }
});

export const {
  entitySelected,
  entityLoaded,
  entityUpdated,
  executionStarted,
  executionCompleted
} = uiSlice.actions;

export default uiSlice.reducer;
