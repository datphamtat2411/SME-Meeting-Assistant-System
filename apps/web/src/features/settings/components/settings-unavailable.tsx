type SettingsUnavailableProps = {
  title: string
  description: string
}

export function SettingsUnavailable({
  title,
  description,
}: SettingsUnavailableProps) {
  return (
    <div
      role='status'
      className='rounded-lg border border-dashed bg-muted/20 p-4'
    >
      <h4 className='font-medium'>{title}</h4>
      <p className='mt-1 text-sm text-muted-foreground'>{description}</p>
      <p className='mt-2 text-sm text-muted-foreground'>
        This settings area is not available in this workspace yet.
      </p>
    </div>
  )
}
