import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth'
import { Calendar, Users, Upload, ArrowRight, Search, Shield } from 'lucide-react'

export default function HomePage() {
  const { user } = useAuthStore()
  
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="container py-4 flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold text-xl">
          <Calendar className="h-7 w-7 text-primary" />
          <span>ClassMate</span>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <Button asChild>
              <Link to="/dashboard">Go to Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button variant="ghost" asChild>
                <Link to="/login">Sign In</Link>
              </Button>
              <Button asChild>
                <Link to="/register">Sign Up</Link>
              </Button>
            </>
          )}
        </div>
      </header>
      
      {/* Hero */}
      <section className="container py-20 md:py-32">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-block px-4 py-1.5 bg-primary/10 text-primary rounded-full text-sm font-medium mb-6">
            For Rutgers University Students
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
            Find Your
            <br />
            <span className="text-primary">Classmates Instantly</span>
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Upload your schedule, automatically match with students in your classes.
            <br />
            Never sit alone in a lecture hall again.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Button size="lg" asChild className="w-full sm:w-auto">
              <Link to="/register">
                Get Started Free
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <Link to="/login">Already have an account?</Link>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-4">
            Use your @rutgers.edu email for unlimited free access
          </p>
        </div>
      </section>
      
      {/* Features */}
      <section className="container py-20 border-t">
        <h2 className="text-2xl md:text-3xl font-bold text-center mb-12">
          How It Works
        </h2>
        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          <div className="text-center p-6">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Upload className="h-7 w-7 text-primary" />
            </div>
            <h3 className="font-semibold text-lg mb-2">1. Upload Your Schedule</h3>
            <p className="text-muted-foreground">
              Take a screenshot of your schedule - our AI automatically extracts all course info
            </p>
          </div>
          
          <div className="text-center p-6">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Search className="h-7 w-7 text-primary" />
            </div>
            <h3 className="font-semibold text-lg mb-2">2. Find Classmates</h3>
            <p className="text-muted-foreground">
              Automatically match with students in the same section, time slot, and professor
            </p>
          </div>
          
          <div className="text-center p-6">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <h3 className="font-semibold text-lg mb-2">3. Connect & Study</h3>
            <p className="text-muted-foreground">
              Exchange contact info, form study groups, and ace your classes together
            </p>
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className="container py-20 border-t">
        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mb-4">
              <Shield className="h-7 w-7 text-green-600" />
            </div>
            <h2 className="text-2xl md:text-3xl font-bold mb-4">
              Your Privacy Matters
            </h2>
            <p className="text-muted-foreground mb-4">
              You control who sees your contact information. Choose to share publicly, 
              or require classmates to request access first.
            </p>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                Control visibility per course room
              </li>
              <li className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                Approve or deny contact requests
              </li>
              <li className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                One-click auto-share for convenience
              </li>
            </ul>
          </div>
          <div className="bg-muted/50 rounded-2xl p-8">
            <div className="space-y-4">
              <div className="bg-background rounded-lg p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10" />
                  <div>
                    <p className="font-medium">John D.</p>
                    <p className="text-xs text-muted-foreground">Intro to CS - Section 01</p>
                  </div>
                </div>
              </div>
              <div className="bg-background rounded-lg p-4 shadow-sm border-2 border-primary">
                <p className="text-sm font-medium mb-2">Share your contact info?</p>
                <div className="flex gap-2">
                  <div className="flex-1 bg-primary/10 text-primary text-xs py-2 rounded text-center">
                    Share with classmates
                  </div>
                  <div className="flex-1 bg-muted text-muted-foreground text-xs py-2 rounded text-center">
                    Keep private
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      
      {/* CTA */}
      <section className="container py-20 border-t">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl md:text-3xl font-bold mb-4">
            Ready to Find Your Study Buddies?
          </h2>
          <p className="text-muted-foreground mb-8">
            Just one schedule screenshot away from connecting with classmates
          </p>
          <Button size="lg" asChild>
            <Link to="/register">
              Sign Up Free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>
      
      {/* Footer */}
      <footer className="container py-8 border-t text-center text-sm text-muted-foreground">
        <p>© 2025 ClassMate. Making college less lonely, one class at a time.</p>
      </footer>
    </div>
  )
}
