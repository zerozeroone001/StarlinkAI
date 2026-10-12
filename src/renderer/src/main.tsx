import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { useApp } from './stores/app'
import { WorkspaceStorageGate } from './components/WorkspaceStorageGate'
import { registerWorkspaceLifecycle } from './lib/workspace-lifecycle'
import './styles.css'
import './workspace.css'

registerWorkspaceLifecycle()

if (import.meta.env.DEV) {
  ;(window as unknown as { __GROK_STORE: typeof useApp }).__GROK_STORE = useApp
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkspaceStorageGate><App /></WorkspaceStorageGate>
  </React.StrictMode>
)
