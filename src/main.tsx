import { createRoot } from 'react-dom/client';
import { ConsoleApp } from './ui/ConsoleApp';
import { ObsWindow } from './ui/ObsWindow';
import './style.css';

const isObs = new URLSearchParams(location.search).get('view') === 'obs';
document.documentElement.classList.toggle('obs-page', isObs);
createRoot(document.getElementById('root')!).render(isObs ? <ObsWindow /> : <ConsoleApp />);
