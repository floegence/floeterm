import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { installFrontendPerfProbe } from './perfProbe';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';

installFrontendPerfProbe();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
