import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import App from './components/App';
import { store } from './store';
import './styles.css';

// Use the locally-installed Monaco instead of the CDN, so the app works offline.
loader.config({ monaco });

// Provide a no-op worker so Monaco doesn't try to spawn language-service workers
// we don't need (GLSL uses a custom Monarch tokenizer, not a language server).
window.MonacoEnvironment = {
  getWorker() {
    return new Worker(
      URL.createObjectURL(new Blob([''], { type: 'application/javascript' }))
    );
  }
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <App />
  </Provider>
);
