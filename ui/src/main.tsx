import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeStyle } from '@demo/design/react';
import { ResourcePage } from './ResourcePage';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeStyle />
    <ResourcePage collectionPath="/todos" />
  </StrictMode>,
);
