import './style.css';
import { createApp } from './app';
export { CareerView } from './career/view'; // Mounts #nav-career -> /career studio view

const { bootstrap } = createApp();
void bootstrap();
