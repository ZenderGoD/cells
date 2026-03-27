import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/lib/store'
import { hapticSuccess } from '@/lib/haptics'

interface NewProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
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
    setName('')
    setPath('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Folder</label>
            <div className="flex gap-2">
              <button
                onClick={handlePickFolder}
                className="flex-1 flex items-center gap-2 h-8 px-3 rounded-lg border border-input bg-transparent text-sm text-left hover:bg-muted transition-colors"
              >
                <FolderOpen className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className={path ? 'text-foreground truncate' : 'text-muted-foreground'}>
                  {path || 'Choose a folder...'}
                </span>
              </button>
            </div>
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
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={!name.trim() || !path.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
