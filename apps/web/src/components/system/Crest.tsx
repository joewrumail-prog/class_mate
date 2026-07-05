const SHIELD_PATH = 'M28 3 L50 9 V27 C50 41 40 49 28 53 C16 49 6 41 6 27 V9 Z'

interface CrestProps {
  letter: string
  size?: number
  variant?: 'solid' | 'ghost' | 'dashed'
  className?: string
}

/**
 * Generic school shield crest. `solid` = brand-800 fill + white letter,
 * `ghost` = white 6% fill for hero watermarks, `dashed` = dashed outline
 * for empty states. Brand comes only from --brand-* (never hard-coded).
 */
export default function Crest({ letter, size = 34, variant = 'solid', className }: CrestProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 56 56"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {variant === 'solid' && (
        <>
          <path d={SHIELD_PATH} className="fill-brand-800" stroke="rgba(0,0,0,0.12)" strokeWidth="1" />
          <text
            x="28"
            y="29"
            textAnchor="middle"
            dominantBaseline="central"
            fontWeight="800"
            fontSize="26"
            fill="#ffffff"
            letterSpacing="-0.5"
          >
            {letter}
          </text>
        </>
      )}
      {variant === 'ghost' && (
        <>
          <path d={SHIELD_PATH} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
          <text
            x="28"
            y="29"
            textAnchor="middle"
            dominantBaseline="central"
            fontWeight="800"
            fontSize="26"
            fill="rgba(255,255,255,0.10)"
          >
            {letter}
          </text>
        </>
      )}
      {variant === 'dashed' && (
        <>
          <path d={SHIELD_PATH} fill="none" className="stroke-brand-800" strokeWidth="2" strokeDasharray="4 4" />
          <text
            x="28"
            y="29"
            textAnchor="middle"
            dominantBaseline="central"
            fontWeight="800"
            fontSize="24"
            className="fill-brand-800"
          >
            {letter}
          </text>
        </>
      )}
    </svg>
  )
}
