import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload, Image, Check, Edit2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getCurrentSemester, getAvailableSemesters, type SemesterInfo, parseSemesterId } from '@/lib/semester'
import { authFetch } from '@/lib/api'
import * as pdfjsLib from 'pdfjs-dist'

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
  const [indexInput, setIndexInput] = useState('')
  const [joiningByIndex, setJoiningByIndex] = useState(false)
  
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
    const workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`
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

    await page.render({ canvasContext: context, viewport }).promise
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
      toast.error(error.message || 'Parse failed, please try again')
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

  const handleIndexJoin = async () => {
    if (!user?.id) {
      toast.error('Please login first')
      return
    }

    const parsed = parseSemesterId(semester)
    if (!parsed) {
      toast.error('Invalid semester')
      return
    }

    const indices = indexInput
      .split(/[\s,\n]+/)
      .map((value) => value.trim())
      .filter(Boolean)

    if (indices.length === 0) {
      toast.error('Please enter at least one index number')
      return
    }

    setJoiningByIndex(true)
    let successCount = 0

    try {
      for (const index of indices) {
        const res = await authFetch(`${API_URL}/api/rooms/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            index,
            year: parsed.year,
            term: parsed.term,
          }),
        })
        const data = await res.json()
        if (!data.success) {
          throw new Error(data.error || `Failed to join ${index}`)
        }
        successCount += 1
      }

      toast.success(`Added ${successCount} course${successCount > 1 ? 's' : ''}`)
      navigate('/dashboard')
    } catch (error: any) {
      toast.error(error.message || 'Failed to add courses')
    } finally {
      setJoiningByIndex(false)
    }
  }
  
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Import Schedule</h1>
        <p className="text-muted-foreground">Upload a schedule screenshot for AI to extract course info</p>
      </div>

      {/* Semester Selector */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <Label>Semester:</Label>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={semester}
              onChange={(e) => setSemester(e.target.value)}
            >
              {availableSemesters.map((sem) => (
                <option key={sem.id} value={sem.id}>
                  {sem.display}
                </option>
              ))}
            </select>
            <span className="text-sm text-muted-foreground">
              Rutgers New Brunswick
            </span>
          </div>
        </CardContent>
      </Card>
      
      {/* Step 1: Upload */}
      {step === 'upload' && (
        <Card>
          <CardHeader>
            <CardTitle>Upload Schedule</CardTitle>
            <CardDescription>
              Supports PNG, JPG, JPEG, WebP, and PDF formats (first page), max 15MB
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                isDragActive 
                  ? 'border-primary bg-primary/5' 
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
            >
              <input {...getInputProps()} />
              
              {imagePreview ? (
                <div className="space-y-4">
                  <img 
                    src={imagePreview} 
                    alt="Schedule preview" 
                    className="max-h-64 mx-auto rounded-lg shadow-md"
                  />
                  <p className="text-sm text-muted-foreground">
                    Click or drag to replace image
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
                    {isDragActive ? (
                      <Image className="h-8 w-8 text-primary" />
                    ) : (
                      <Upload className="h-8 w-8 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <p className="font-medium">
                      {isDragActive ? 'Drop to upload' : 'Drag image here'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      or click to select file
                    </p>
                  </div>
                </div>
              )}
            </div>
            
            {imageFile && (
              <Button className="w-full" onClick={handleParse}>
                Start Recognition
              </Button>
            )}

            <div className="border-t pt-4">
              <h3 className="font-medium mb-2">Add courses by Rutgers index</h3>
              <p className="text-sm text-muted-foreground mb-3">
                Paste index numbers separated by commas, spaces, or new lines.
              </p>
              <textarea
                className="w-full min-h-[96px] rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                placeholder="Example: 11396, 10364\n14567"
                value={indexInput}
                onChange={(e) => setIndexInput(e.target.value)}
              />
              <Button
                className="w-full mt-3"
                onClick={handleIndexJoin}
                disabled={joiningByIndex}
              >
                {joiningByIndex ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Add Courses
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      
      {/* Step 2: Parsing */}
      {step === 'parsing' && (
        <Card>
          <CardContent className="py-12 text-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
            <h3 className="font-semibold mb-2">AI is analyzing your schedule...</h3>
            <p className="text-sm text-muted-foreground">
              This may take a few seconds
            </p>
          </CardContent>
        </Card>
      )}
      
      {/* Step 3: Confirm */}
      {step === 'confirm' && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Confirm Course Information</CardTitle>
              <CardDescription>
                Review the results and click edit to fix any errors
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {parsedCourses.map((course, index) => (
                <div 
                  key={index} 
                  className="border rounded-lg p-4 space-y-3"
                >
                  {editingIndex === index ? (
                    // Editing mode
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label>Course Name</Label>
                          <Input
                            value={course.name}
                            onChange={(e) => handleUpdateCourse(index, 'name', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label>Day</Label>
                          <select 
                            className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                            value={course.day}
                            onChange={(e) => handleUpdateCourse(index, 'day', parseInt(e.target.value))}
                          >
                            {[1, 2, 3, 4, 5, 6, 7].map(d => (
                              <option key={d} value={d}>{dayNames[d]}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label>Start Time</Label>
                          <Input
                            type="time"
                            value={course.startTime}
                            onChange={(e) => handleUpdateCourse(index, 'startTime', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label>End Time</Label>
                          <Input
                            type="time"
                            value={course.endTime}
                            onChange={(e) => handleUpdateCourse(index, 'endTime', e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label>Classroom</Label>
                          <Input
                            value={course.classroom}
                            onChange={(e) => handleUpdateCourse(index, 'classroom', e.target.value)}
                          />
                        </div>
                        <div>
                          <Label>Professor</Label>
                          <Input
                            value={course.professor}
                            onChange={(e) => handleUpdateCourse(index, 'professor', e.target.value)}
                          />
                        </div>
                      </div>
                      <div>
                        <Label>Weeks</Label>
                        <Input
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
                    // Display mode
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <h4 className="font-semibold text-lg">{course.name}</h4>
                        <p className="text-sm text-muted-foreground">
                          {dayNames[course.day]} {course.startTime} - {course.endTime}
                        </p>
                        {(course.classroom || course.professor) && (
                          <p className="text-sm text-muted-foreground">
                            {course.classroom && `Room: ${course.classroom}`}
                            {course.classroom && course.professor && ' | '}
                            {course.professor && `Prof: ${course.professor}`}
                          </p>
                        )}
                        {course.weeks && (
                          <p className="text-sm text-muted-foreground">
                            Weeks: {course.weeks}
                          </p>
                        )}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => setEditingIndex(index)}>
                        <Edit2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => setStep('upload')} className="flex-1">
              Re-upload
            </Button>
            <Button onClick={handleConfirm} disabled={saving} className="flex-1">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm Import ({parsedCourses.length} courses)
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
