import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Mic, Square, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { uploadMeetingFile } from './media-api'

export function RecordingPanel({ meetingId }: { meetingId: string }) {
  const qc = useQueryClient()
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const [recording, setRecording] = useState(false)
  const [audio, setAudio] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
    stream.current?.getTracks().forEach(track => track.stop())
  }, [])
  async function begin() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.error('This browser does not support microphone recording.'); return
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = media; chunks.current = []; setAudio(null)
      const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      const mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t))
      const instance = new MediaRecorder(media, mimeType ? { mimeType } : undefined)
      recorder.current = instance
      instance.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      instance.onstop = () => {
        const blob = new Blob(chunks.current, { type: instance.mimeType })
        const ext = instance.mimeType.includes('mp4') ? 'm4a' : instance.mimeType.includes('ogg') ? 'ogg' : 'webm'
        if (blob.size) setAudio(new File([blob], 'meeting-recording-' + Date.now() + '.' + ext, { type: instance.mimeType }))
        media.getTracks().forEach(track => track.stop())
        setRecording(false)
      }
      instance.start(1000); setRecording(true)
    } catch (e) { stream.current?.getTracks().forEach(t => t.stop()); toast.error('Microphone access failed', { description: e instanceof Error ? e.message : undefined }) }
  }
  function stop() { if (recorder.current?.state === 'recording') recorder.current.stop() }
  async function upload() {
    if (!audio) return
    setBusy(true)
    try {
      await uploadMeetingFile(meetingId, audio, 'RECORDING')
      toast.success('Recording uploaded and finalized')
      setAudio(null)
      await qc.invalidateQueries({ queryKey: ['meeting-media', meetingId] })
    } catch (error) { toast.error('Recording upload failed', { description: error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }
  return <Card><CardHeader><CardTitle className='flex items-center gap-2'><Mic className='size-5' />Record meeting audio</CardTitle><p className='text-sm text-muted-foreground'>Microphone access begins only when you click Start. Follow your organization's recording consent policy. Processing occurs after submission.</p></CardHeader>
    <CardContent className='flex flex-wrap items-center gap-3'>{recording ? <Button variant='destructive' onClick={stop}><Square className='size-4' /> Stop recording</Button> : <Button variant='outline' disabled={busy} onClick={() => void begin()}><Mic className='size-4' /> Start recording</Button>}
    {recording && <span role='status' className='text-sm text-destructive'>Recording in progress…</span>}
    {audio && !recording && <><span className='text-sm'>{(audio.size / 1048576).toFixed(1)} MB captured</span><Button disabled={busy} onClick={() => void upload()}><Upload className='size-4' />{busy ? 'Submitting…' : 'Submit recording'}</Button><Button variant='ghost' disabled={busy} onClick={() => setAudio(null)}>Discard</Button></>}
    </CardContent>
  </Card>
}
