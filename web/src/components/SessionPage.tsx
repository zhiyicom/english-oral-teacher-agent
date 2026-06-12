import { Link, useParams } from 'react-router-dom'
import { STRINGS } from '../i18n/strings'

export default function SessionPage() {
  const { id } = useParams()
  return (
    <div data-testid="placeholder">
      <h2 className="text-xl font-semibold text-slate-900">{STRINGS.sessionTitle}</h2>
      <p className="mt-2 text-slate-500">{STRINGS.placeholderSession(id ?? '')}</p>
      <p className="mt-4 text-sm text-slate-400">
        <Link to="/" className="underline hover:text-slate-600">
          ← {STRINGS.navHome}
        </Link>
      </p>
    </div>
  )
}
