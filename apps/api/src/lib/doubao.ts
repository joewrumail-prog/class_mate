import OpenAI from 'openai'

const apiKey = process.env.DOUBAO_API_KEY
const endpointId = process.env.DOUBAO_ENDPOINT_ID || 'doubao-seed-1-6-vision-250815'

if (!apiKey) {
  console.warn('Missing DOUBAO_API_KEY environment variable')
}

export const doubaoClient = new OpenAI({
  apiKey: apiKey || 'placeholder-key',
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
})

export const DOUBAO_ENDPOINT_ID = endpointId

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
- Course names may be in Chinese`

export async function parseScheduleImage(imageBase64: string): Promise<ParsedCourse[]> {
  const response = await doubaoClient.chat.completions.create({
    model: DOUBAO_ENDPOINT_ID,
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
                : `data:image/jpeg;base64,${imageBase64}`
            } 
          },
        ],
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
  })

  const content = response.choices[0].message.content || '[]'
  
  // Extract JSON from response
  const jsonMatch = content.match(/\[[\s\S]*\]/)
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
