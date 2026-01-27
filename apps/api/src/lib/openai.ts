import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY

if (!apiKey) {
  console.warn('Missing OPENAI_API_KEY environment variable')
}

export const openaiClient = new OpenAI({
  apiKey: apiKey || 'placeholder-key',
})

// Use GPT-4 Vision (gpt-4o is the latest multimodal model)
export const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o'

export interface ParsedCourse {
  name: string
  day: number
  startTime: string
  endTime: string
  classroom: string
  professor: string
  weeks: string
}

const SCHEDULE_PARSE_PROMPT = `You are a schedule parsing assistant. Please analyze this class schedule image and extract all course information.

Return a JSON array where each course has these fields:
- name: Course name (string)
- day: Day of week (1=Monday, 2=Tuesday, ..., 7=Sunday)
- startTime: Start time in 24h format (e.g., "08:00")
- endTime: End time in 24h format (e.g., "09:40")
- classroom: Classroom location (string, empty if not visible)
- professor: Professor name (string, empty if not visible)
- weeks: Week range (e.g., "1-16", empty if not visible)

IMPORTANT:
- Only return valid JSON array, no markdown code blocks
- If you cannot identify a field, use empty string ""
- Parse ALL visible courses in the schedule
- Course names may be in Chinese or English
- This is likely a Rutgers University schedule`

export async function parseScheduleImage(imageBase64: string): Promise<ParsedCourse[]> {
  const response = await openaiClient.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: SCHEDULE_PARSE_PROMPT },
          { 
            type: 'image_url', 
            image_url: { 
              url: imageBase64.startsWith('data:') 
                ? imageBase64 
                : `data:image/jpeg;base64,${imageBase64}`,
              detail: 'high'  // Use high detail for better accuracy
            } 
          },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
  })

  const content = response.choices[0].message.content || '[]'
  
  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = content
  
  // Remove markdown code blocks if present
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  }
  
  // Find JSON array
  const jsonMatch = jsonStr.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    console.error('No JSON found in response:', content)
    return []
  }
  
  try {
    return JSON.parse(jsonMatch[0])
  } catch (error) {
    console.error('Failed to parse JSON:', error)
    return []
  }
}
