import { render } from 'solid-js/web';
import { App } from './App';
import { installFrontendPerfProbe } from './perfProbe';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';

installFrontendPerfProbe();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing root element');
}

render(() => <App />, root);
