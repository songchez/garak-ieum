import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectShell from './ProjectShell'
import { DesktopFrame } from './components/DesktopFrame'
import { initializeTheme } from './core/theme'
import './styles.css'

initializeTheme()

createRoot(document.getElementById('root')!).render(<StrictMode><DesktopFrame><ProjectShell/></DesktopFrame></StrictMode>)
