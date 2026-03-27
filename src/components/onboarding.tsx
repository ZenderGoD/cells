import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/lib/store'
import { hapticSuccess } from '@/lib/haptics'

export function Onboarding() {
  const createProject = useStore((s) => s.createProject)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')

  const handlePickFolder = async () => {
    const selected = await window.cells.app.pickFolder()
    if (selected) {
      setPath(selected)
      if (!name) {
        setName(selected.split('/').pop() || '')
      }
    }
  }

  const handleCreate = () => {
    if (!name.trim() || !path.trim()) return
    hapticSuccess()
    createProject(name.trim(), path.trim())
  }

  return (
    <div className="h-full flex items-center justify-center bg-canvas">
      <div className="w-full max-w-sm space-y-6 px-6">
        <div className="text-center space-y-2">
          <h1 className="text-lg font-medium text-foreground">Welcome to Cells</h1>
          <p className="text-sm text-muted-foreground">
            Pick a folder to create your first project.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Folder</label>
            <button
              onClick={handlePickFolder}
              className="w-full flex items-center gap-2 h-9 px-3 rounded-lg border border-input bg-transparent text-sm text-left hover:bg-muted transition-colors"
            >
              <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className={path ? 'text-foreground truncate' : 'text-muted-foreground'}>
                {path || 'Choose a folder...'}
              </span>
            </button>
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>

          <Button className="w-full" onClick={handleCreate} disabled={!name.trim() || !path.trim()}>
            Create Project
          </Button>
        </div>
      </div>
    </div>
  )
}
