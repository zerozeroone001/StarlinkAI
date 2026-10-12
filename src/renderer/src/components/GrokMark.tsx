import { useId } from 'react'

export function GrokMark({ size = 22 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="9" fill="#111" />
      <path
        d="M16 5.5L17.9 13.1L25.5 15L17.9 16.9L16 24.5L14.1 16.9L6.5 15L14.1 13.1L16 5.5Z"
        fill={`url(#${id})`}
      />
      <defs>
        <linearGradient id={id} x1="16" y1="5.5" x2="16" y2="24.5">
          <stop stopColor="#F7EEFF" />
          <stop offset="1" stopColor="#C084FC" />
        </linearGradient>
      </defs>
    </svg>
  )
}
