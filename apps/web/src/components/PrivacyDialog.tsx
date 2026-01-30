import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'

interface PrivacyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  roomName: string
  onConfirm: (isPublic: boolean) => void
}

export function PrivacyDialog({ open, onOpenChange, roomName, onConfirm }: PrivacyDialogProps) {
  const [loading, setLoading] = useState(false)

  const handleChoice = async (isPublic: boolean) => {
    setLoading(true)
    try {
      await onConfirm(isPublic)
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Privacy Settings</DialogTitle>
          <DialogDescription>
            Choose whether to share your contact info with classmates in <strong>{roomName}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border p-4 hover:bg-accent/50 cursor-pointer transition-colors"
               onClick={() => !loading && handleChoice(true)}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-green-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <div>
                <p className="font-medium">Share with classmates</p>
                <p className="text-sm text-muted-foreground">
                  Your WeChat/QQ will be visible to everyone in this room
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border p-4 hover:bg-accent/50 cursor-pointer transition-colors"
               onClick={() => !loading && handleChoice(false)}>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              </div>
              <div>
                <p className="font-medium">Keep private</p>
                <p className="text-sm text-muted-foreground">
                  Classmates will need to request to see your contact info
                </p>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <p className="text-xs text-muted-foreground">
            You can change this anytime in room settings or enable "Auto-share" in your profile
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
