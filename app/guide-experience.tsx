import { useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Globe2,
  Pause,
  Play,
  Route,
} from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

const concepts = [
  {
    icon: Globe2,
    title: 'Your domain',
    kind: 'domain',
    example: 'notes.example.com',
    description:
      'The address people visit. Point its DNS record at your Nginx server.',
  },
  {
    icon: Route,
    title: 'The right path',
    kind: 'rule',
    example: '/api/ → notes service',
    description:
      'Choose which requests reach each app. The longest matching path takes priority.',
  },
  {
    icon: Box,
    title: 'Your service',
    kind: 'service',
    example: 'http://notes:3000',
    description:
      'The destination behind your proxy. Use a Docker service name or a reachable IP address.',
  },
];
const tips = [
  {
    title: 'Make room to experiment.',
    text: 'Your draft is a safe place to build. Saving it does not change live traffic. Validate your configuration, then deploy when you are ready.',
  },
  {
    title: 'One service. Many front doors.',
    text: 'Multiple domains and path rules can share the same service. Reuse a destination when adding a route to keep your network easy to maintain.',
  },
  {
    title: 'Follow the request first.',
    text: 'Use Trace route to simulate which destination a URL will reach. It checks your routing rules locally, without sending a network request.',
  },
];

export function GuideExperience({
  children,
  onCreate,
  onNetwork,
}: {
  children: ReactNode;
  onCreate: () => void;
  onNetwork: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [tip, setTip] = useState(0);
  const [paused, setPaused] = useState(false);
  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.guide-hero .reveal-word', {
          opacity: 0.1,
          stagger: 0.08,
          scrollTrigger: {
            trigger: '.guide-hero',
            start: 'top 65%',
            end: 'bottom 60%',
            scrub: 1,
          },
        });
        gsap.from('.concept-card', {
          y: 22,
          opacity: 0,
          stagger: 0.1,
          duration: 0.6,
          scrollTrigger: { trigger: '.concept-grid', start: 'top 90%' },
        });
      });
      media.add(
        '(min-width: 1000px) and (prefers-reduced-motion: no-preference)',
        () => {
          const cards = gsap.utils.toArray<HTMLElement>('.guide-wide');
          cards.slice(0, -1).forEach((card, index) => {
            gsap.fromTo(
              cards[index + 1],
              { y: 48 },
              {
                y: -28,
                scrollTrigger: {
                  trigger: cards[index + 1],
                  start: 'top bottom',
                  end: 'top 25%',
                  scrub: true,
                },
              },
            );
            gsap.to(card, {
              scale: 0.97,
              transformOrigin: 'top center',
              scrollTrigger: {
                trigger: cards[index + 1],
                start: 'top bottom',
                end: 'top top+=110',
                scrub: true,
              },
            });
          });
        },
      );
      return () => media.revert();
    },
    { scope: root },
  );

  return (
    <div className="guide-experience" ref={root}>
      <section className="guide-hero">
        <h2 className="max-w-5xl">
          A clear path.
          <br />
          For every request.
        </h2>
        <p>
          {'A domain, a path, a destination. Bring your infrastructure together, one connection at a time.'
            .split(' ')
            .map((word, index) => (
              <span className="reveal-word" key={index}>
                {word}{' '}
              </span>
            ))}
        </p>
        <div className="guide-actions">
          <button className="btn primary" onClick={onCreate}>
            Create a route <ArrowRight size={17} />
          </button>
          <button className="btn" onClick={onNetwork}>
            Explore your network
          </button>
        </div>
      </section>
      <div
        className={`capability-marquee ${paused ? 'is-paused' : ''}`}
        aria-label="Domains, path routing, Docker services, HTTPS, WebSockets"
      >
        <button
          className="marquee-toggle icon-btn"
          aria-label={
            paused ? 'Play feature animation' : 'Pause feature animation'
          }
          onClick={() => setPaused(!paused)}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>
        <div aria-hidden="true">
          {[0, 1].map((copy) => (
            <span key={copy}>
              Domains <span>·</span> Path routing <span>·</span> Docker services{' '}
              <span>·</span> HTTPS <span>·</span> WebSockets <span>·</span>
            </span>
          ))}
        </div>
      </div>
      <section
        className="concept-grid grid-flow-dense"
        aria-label="How routing works"
      >
        {concepts.map((concept, index) => (
          <article
            className={`concept-card ${concept.kind} ${active === index ? 'is-expanded' : ''}`}
            key={concept.kind}
          >
            <button
              aria-expanded={active === index}
              aria-controls={`concept-${concept.kind}`}
              onClick={() => setActive(index)}
            >
              <span className={`type-icon ${concept.kind}`}>
                <concept.icon size={23} />
              </span>
              <h3>{concept.title}</h3>
              <ArrowRight size={18} />
            </button>
            <div id={`concept-${concept.kind}`} className="concept-detail">
              <p>{concept.description}</p>
              <code>{concept.example}</code>
            </div>
          </article>
        ))}
      </section>
      <div className="guide-grid grid-flow-dense">{children}</div>
      <section
        className="guide-tip"
        aria-roledescription="carousel"
        aria-label="Workspace tips"
      >
        <div aria-live="polite" aria-atomic="true">
          <span className="tip-caption">A little clarity goes a long way</span>
          <h2>{tips[tip].title}</h2>
          <p>{tips[tip].text}</p>
        </div>
        <div className="tip-controls">
          <span>
            {tip + 1} / {tips.length}
          </span>
          <button
            className="btn"
            aria-label="Previous tip"
            onClick={() => setTip((tip + tips.length - 1) % tips.length)}
          >
            <ArrowLeft size={18} />
          </button>
          <button
            className="btn"
            aria-label="Next tip"
            onClick={() => setTip((tip + 1) % tips.length)}
          >
            <ArrowRight size={18} />
          </button>
        </div>
      </section>
      <footer className="guide-cta">
        <h2>
          Your next connection
          <br />
          starts here.
        </h2>
        <button className="btn primary" onClick={onCreate}>
          Create a route <ArrowRight size={18} />
        </button>
      </footer>
    </div>
  );
}
