import { createRoot } from 'react-dom/client';
import { ConsoleApp } from './ui/ConsoleApp';
import { ObsWindow } from './ui/ObsWindow';
import './style.css';

createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('view') === 'obs' ? <ObsWindow /> : <ConsoleApp />);
