import './app.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { initSentry } from './lib/sentry';

initSentry();

const target = document.getElementById('app');
if (!target) throw new Error('#app element not found');

export default mount(App, { target });
