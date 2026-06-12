import { Link } from 'react-router-dom'
import { STRINGS } from '../../i18n/strings'

export default function Header() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
        <Link to="/" className="block">
          <h1 className="text-2xl font-bold text-slate-900">{STRINGS.appTitle}</h1>
          <p className="text-sm text-slate-500">{STRINGS.appSubtitle}</p>
        </Link>
        <nav className="flex gap-4 text-sm">
          <Link
            to="/settings"
            className="text-slate-600 hover:text-slate-900"
            data-testid="nav-settings"
          >
            {STRINGS.navSettings}
          </Link>
        </nav>
      </div>
    </header>
  )
}
