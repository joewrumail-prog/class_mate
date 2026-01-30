import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload, Image, Check, Edit2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getCurrentSemester, getAvailableSemesters } from '@/lib/semester'
import { authFetch } from '@/lib/api'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min?url'

interface ParsedCourse {
  name: string
  day: number
  startTime: string
  endTime: string
  classroom: string
  professor: string
  weeks: string
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'
const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function ImportSchedulePage() {
  const navigate = useNavigate()
  const { user } = useAuthStore()
  
  const [step, setStep] = useState<'upload' | 'parsing' | 'confirm'>('upload')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [sourceDataUrl, setSourceDataUrl] = useState<string | null>(null)
  const [parsedCourses, setParsedCourses] = useState<ParsedCourse[]>([])
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  
  // Auto-detect current semester
  const availableSemesters = getAvailableSemesters()
  const [semester, setSemester] = useState(getCurrentSemester().id)
  
  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0]
    if (!file) return

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const isImage = file.type.startsWith('image/')

    if (!isPdf && !isImage) {
      toast.error('Please upload an image or PDF file')
      return
    }

    if (file.size > 15 * 1024 * 1024) {
      toast.error('File must be under 15MB')
      return
    }

    setImageFile(file)
    setSourceDataUrl(null)

    if (isPdf) {
      try {
        const dataUrl = await pdfToDataUrl(file)
        setImagePreview(dataUrl)
        setSourceDataUrl(dataUrl)
      } catch (error: any) {
        console.error('PDF render error:', error)
        toast.error('Failed to read PDF. Please try another file.')
        setImageFile(null)
        setImagePreview(null)
      }
      return
    }

    setImagePreview(URL.createObjectURL(file))
  }, [])
  
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.webp'],
      'application/pdf': ['.pdf'],
    },
    maxFiles: 1,
  })
  
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = error => reject(error)
    })
  }

  const pdfToDataUrl = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer()
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
    const pdf = await loadingTask.promise
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = viewport.width
    canvas.height = viewport.height

    if (!context) {
      throw new Error('Canvas not supported')
    }

    await page.render({ canvasContext: context, viewport, canvas }).promise
    return canvas.toDataURL('image/png')
  }
  
  const handleParse = async () => {
    if (!imageFile) return
    
    setStep('parsing')
    
    try {
      const base64Image = sourceDataUrl || await fileToBase64(imageFile)
      
      // Call API to parse schedule
      const response = await authFetch(`${API_URL}/api/schedule/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: base64Image,
          semester,
        }),
      })
      
      const result = await response.json()
      
      if (!result.success) {
        throw new Error(result.error || 'Parse failed')
      }
      
      if (result.courses.length === 0) {
        toast.error('No courses detected. Please upload a clear schedule screenshot.')
        setStep('upload')
        return
      }
      
      setParsedCourses(result.courses)
      setStep('confirm')
      toast.success(`Detected ${result.courses.length} courses`)
    } catch (error: any) {
      console.error('Parse error:', error)
      if (error?.message?.includes('quota')) {
        toast.error('Daily upload quota reached. Please try again tomorrow.')
      } else {
        toast.error(error.message || 'Parse failed, please try again')
      }
      setStep('upload')
    }
  }
  
  const handleUpdateCourse = (index: number, field: keyof ParsedCourse, value: string | number) => {
    const updated = [...parsedCourses]
    updated[index] = { ...updated[index], [field]: value }
    setParsedCourses(updated)
  }
  
  const handleRemoveCourse = (index: number) => {
    setParsedCourses(courses => courses.filter((_, i) => i !== index))
    setEditingIndex(null)
  }
  
  const handleConfirm = async () => {
    if (parsedCourses.length === 0) {
      toast.error('Please keep at least one course')
      return
    }
    
    if (!user?.id) {
      toast.error('Please login first')
      return
    }
    
    setSaving(true)
    
    try {
      const response = await authFetch(`${API_URL}/api/schedule/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: user.id,
          semester,
          school: 'Rutgers University - New Brunswick',
          courses: parsedCourses,
        }),
      })
      
      const result = await response.json()
      
      if (!result.success) {
        throw new Error(result.error || 'Save failed')
      }
      
      toast.success(result.message || 'Schedule imported successfully!')
      navigate('/dashboard')
    } catch (error: any) {
      console.error('Confirm error:', error)
      toast.error(error.message || 'Save failed, please try again')
    } finally {
      setSaving(false)
    }
  }

  
  return (
    <div className="min-h-screen bg-[#F8FAFC] py-10">
      <div className="max-w-5xl mx-auto px-4 md:px-6 space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-[#1F2937]">Import Schedule</h1>
        <p className="text-sm text-[#6B7280]">Upload a schedule screenshot or PDF for AI to extract course info.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-medium">
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${step === 'upload' ? 'border-[#1E40AF] bg-[#EFF6FF] text-[#1E40AF]' : 'border-[#E2E8F0] bg-white text-[#6B7280]'}`}>
            <span className="h-6 w-6 rounded-full flex items-center justify-center border border-current bg-white">1</span>
            Upload & Parse
          </div>
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${step === 'confirm' ? 'border-[#1E40AF] bg-[#EFF6FF] text-[#1E40AF]' : 'border-[#E2E8F0] bg-white text-[#6B7280]'}`}>
            <span className="h-6 w-6 rounded-full flex items-center justify-center border border-current bg-white">2</span>
            Verify Courses
          </div>
          <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${step === 'confirm' && saving ? 'border-[#1E40AF] bg-[#EFF6FF] text-[#1E40AF]' : 'border-[#E2E8F0] bg-white text-[#6B7280]'}`}>
            <span className="h-6 w-6 rounded-full flex items-center justify-center border border-current bg-white">3</span>
            Done
          </div>
        </div>
      </div>

      <Card className="border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)] rounded-2xl overflow-hidden">
        <CardContent className="p-6 md:p-8 space-y-6 bg-[radial-gradient(circle_at_top,#EFF6FF_0%,#FFFFFF_45%)]">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <h2 className="text-lg font-medium text-[#1F2937]">Semester</h2>
              <p className="text-sm text-[#6B7280]">Select the term you want to match.</p>
            </div>
            <div className="flex items-center gap-3">
              <Label className="text-sm text-[#6B7280]">Semester:</Label>
              <select
                className="h-12 rounded-md border border-[#E2E8F0] bg-white px-4 text-sm text-[#1F2937] transition-all focus:outline-none focus:ring-2 focus:ring-[#1E40AF]/20 focus:border-[#1E40AF]/60"
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
              >
                {availableSemesters.map((sem) => (
                  <option key={sem.id} value={sem.id}>
                    {sem.display}
                  </option>
                ))}
              </select>
              <span className="text-xs text-[#6B7280]">Rutgers New Brunswick</span>
            </div>
          </div>

          {step === 'upload' && (
            <div className="space-y-4">
              {!user?.is_edu_email && (
                <div className="rounded-lg border border-[#E2E8F0] bg-white px-4 py-3 text-sm text-[#6B7280]">
                  <span className="font-medium text-[#1F2937]">Daily upload quota:</span>{' '}
                  {typeof user?.match_quota_remaining === 'number'
                    ? `${user.match_quota_remaining} remaining today.`
                    : '3 uploads per day.'}
                </div>
              )}
              <div
                {...getRootProps()}
                className={`rounded-xl border-2 border-dashed p-8 text-center transition-all cursor-pointer ${
                  isDragActive
                    ? 'border-[#1E40AF] bg-[#EFF6FF]'
                    : 'border-[#1E40AF]/40 bg-[#EFF6FF] hover:border-[#1E40AF] hover:shadow-sm'
                }`}
              >
                <input {...getInputProps()} />
                {imagePreview ? (
                  <div className="space-y-4">
                    <img
                      src={imagePreview}
                      alt="Schedule preview"
                      className="max-h-64 mx-auto rounded-lg shadow-md transition-transform duration-300 hover:scale-[1.01]"
                    />
                    <p className="text-sm text-[#6B7280]">Click or drag to replace file</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="w-16 h-16 rounded-full bg-white flex items-center justify-center mx-auto shadow-sm">
                      {isDragActive ? (
                        <Image className="h-8 w-8 text-[#1E40AF]" />
                      ) : (
                        <Upload className="h-8 w-8 text-[#1E40AF]" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-base font-medium text-[#1F2937]">Drag & drop your schedule here</p>
                      <p className="text-sm text-[#6B7280]">AI will extract course details. Supports PNG, JPG, PDF.</p>
                    </div>
                    <Button variant="outline" className="border-[#1E40AF] text-[#1E40AF] bg-white hover:bg-[#EFF6FF]">
                      Or Browse Files
                    </Button>
                  </div>
                )}
              </div>

              {imageFile && (
                <Button className="w-full bg-[#1E40AF] text-white hover:bg-[#1E40AF]/90 shadow-sm" onClick={handleParse}>
                  Start Recognition
                </Button>
              )}
            </div>
          )}

          {step === 'parsing' && (
            <div className="py-10 text-center space-y-3">
              <Loader2 className="h-10 w-10 animate-spin text-[#1E40AF] mx-auto" />
              <h3 className="text-base font-medium text-[#1F2937]">Analyzing your document...</h3>
              <p className="text-sm text-[#6B7280]">This usually takes a few seconds.</p>
            </div>
          )}

          {step === 'confirm' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-medium text-[#1F2937]">Found {parsedCourses.length} Courses</h2>
                  <p className="text-sm text-[#6B7280]">Verify the details before importing.</p>
                </div>
                <Button variant="outline" onClick={() => setStep('upload')}>
                  ← Upload different file
                </Button>
              </div>

              <div className="space-y-3">
                {parsedCourses.map((course, index) => (
                  <div key={index} className="rounded-xl border border-[#E2E8F0] bg-white p-4 transition-all hover:shadow-md hover:-translate-y-0.5">
                    {editingIndex === index ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label>Course Name</Label>
                            <Input
                              className="h-12"
                              value={course.name}
                              onChange={(e) => handleUpdateCourse(index, 'name', e.target.value)}
                            />
                          </div>
                          <div>
                            <Label>Day</Label>
                            <select
                              className="w-full h-12 rounded-md border border-[#E2E8F0] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#1E40AF]/20 focus:border-[#1E40AF]/60"
                              value={course.day}
                              onChange={(e) => handleUpdateCourse(index, 'day', parseInt(e.target.value))}
                            >
                              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                                <option key={d} value={d}>{dayNames[d]}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label>Start Time</Label>
                            <Input
                              type="time"
                              className="h-12"
                              value={course.startTime}
                              onChange={(e) => handleUpdateCourse(index, 'startTime', e.target.value)}
                            />
                          </div>
                          <div>
                            <Label>End Time</Label>
                            <Input
                              type="time"
                              className="h-12"
                              value={course.endTime}
                              onChange={(e) => handleUpdateCourse(index, 'endTime', e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div>
                            <Label>Classroom</Label>
                          <Input
                            className="h-12"
                            value={course.classroom}
                            onChange={(e) => handleUpdateCourse(index, 'classroom', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label>Professor</Label>
                          <Input
                            className="h-12"
                            value={course.professor}
                            onChange={(e) => handleUpdateCourse(index, 'professor', e.target.value)}
                          />
                        </div>
                      </div>
                        <div>
                          <Label>Weeks</Label>
                        <Input
                          className="h-12"
                          value={course.weeks}
                          placeholder="e.g. 1-16"
                          onChange={(e) => handleUpdateCourse(index, 'weeks', e.target.value)}
                        />
                      </div>
                        <div className="flex gap-2">
                        <Button size="sm" onClick={() => setEditingIndex(null)}>
                          <Check className="h-4 w-4 mr-1" />
                          Done
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => handleRemoveCourse(index)}>
                          Remove
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full bg-[#0D9488]" />
                            <span className="text-sm font-medium text-[#1E40AF]">{course.name}</span>
                          </div>
                          <p className="text-sm text-[#6B7280]">
                            {dayNames[course.day]} {course.startTime} - {course.endTime}
                          </p>
                          {(course.classroom || course.professor) && (
                            <p className="text-xs text-[#6B7280]">
                              {course.classroom && `Room: ${course.classroom}`}
                              {course.classroom && course.professor && ' · '}
                              {course.professor && `Prof: ${course.professor}`}
                            </p>
                          )}
                          {course.weeks && (
                            <p className="text-xs text-[#6B7280]">Weeks: {course.weeks}</p>
                          )}
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => setEditingIndex(index)}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  ← Upload different file
                </Button>
                <Button
                  onClick={handleConfirm}
                  disabled={saving}
                  className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]/90"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Confirm & Import {parsedCourses.length} Courses
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  )
}
