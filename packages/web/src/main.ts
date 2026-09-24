import { renderShell } from './app.js';

const root = document.querySelector<HTMLDivElement>('#app');
if (root) {
  root.innerHTML = renderShell();
}
