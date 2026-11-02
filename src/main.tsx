import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectShell from './ProjectShell'
import { initializeTheme } from './core/theme'
import './styles.css'

initializeTheme()

createRoot(document.getElementById('root')!).render(<StrictMode><ProjectShell/></StrictMode>)
