import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

interface FormValues {
  email: string
  password: string
}

export function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [serverError, setServerError] = useState<string | null>(null)
  const [googleLoading, setGoogleLoading] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>()

  async function onSubmit(values: FormValues) {
    setServerError(null)
    const { error } = await signIn(values.email, values.password)
    if (error) {
      setServerError(error)
    } else {
      navigate('/')
    }
  }

  async function signInWithGoogle() {
    setGoogleLoading(true)
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/` },
    })
    setGoogleLoading(false)
  }

  return (
    <div className="min-h-screen flex">
      {/* Left — form */}
      <div className="flex-1 flex items-center justify-center px-8 py-12 bg-white">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <span className="text-2xl font-bold text-blue-600 tracking-tight">LinkedReach</span>
            <h1 className="mt-6 text-2xl font-bold text-gray-900">Welcome back</h1>
            <p className="mt-1 text-sm text-gray-500">Sign in to your account</p>
          </div>

          {/* Google */}
          <button
            type="button"
            onClick={() => void signInWithGoogle()}
            disabled={googleLoading}
            className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors disabled:opacity-60 mb-5"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            {googleLoading ? 'Redirecting…' : 'Continue with Google'}
          </button>

          <div className="relative mb-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-white px-3 text-gray-400">or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
              <input
                type="email"
                autoComplete="email"
                autoFocus
                placeholder="you@company.com"
                className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-400"
                {...register('email', {
                  required: 'Email is required',
                  pattern: { value: /\S+@\S+\.\S+/, message: 'Enter a valid email' },
                })}
              />
              {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-gray-700">Password</label>
              </div>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-400"
                {...register('password', { required: 'Password is required' })}
              />
              {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
            </div>

            {serverError && (
              <div className="px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                {serverError}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-gray-500">
            Don't have an account?{' '}
            <Link to="/signup" className="text-blue-600 hover:underline font-semibold">
              Sign up free
            </Link>
          </p>
        </div>
      </div>

      {/* Right — visual panel */}
      <div className="hidden lg:flex flex-1 bg-gradient-to-br from-blue-600 to-indigo-700 items-center justify-center p-12 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-white/5 rounded-full" />
        <div className="absolute -bottom-24 -left-24 w-80 h-80 bg-white/5 rounded-full" />

        <div className="relative z-10 max-w-sm text-white">
          <div className="text-4xl font-bold mb-3 leading-tight">
            LinkedIn outreach<br />on autopilot
          </div>
          <p className="text-blue-100 text-sm mb-8 leading-relaxed">
            Manage multiple LinkedIn accounts, run automated sequences, and qualify leads with AI — all in one place.
          </p>

          <div className="space-y-4">
            {[
              { icon: '🔍', text: 'Scrape up to 2,500 leads from Sales Navigator per search' },
              { icon: '⚡', text: 'Run multi-step outreach sequences across all your accounts' },
              { icon: '🤖', text: 'AI qualifies leads and personalises every message automatically' },
              { icon: '📥', text: 'Unified inbox — all replies from all accounts in one view' },
            ].map((f, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="text-lg mt-0.5">{f.icon}</span>
                <p className="text-sm text-blue-100 leading-relaxed">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
