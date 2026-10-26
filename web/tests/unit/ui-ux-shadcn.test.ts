import { describe, expect, it } from 'vitest';
import { cleanLessonTitle, createSvgThumbnailDataUri, formatModuleBadge, toTitleCase } from '../../src/discovery/view';
import {
  cn,
  detectPlatformCapabilities,
  mountAdaptiveShadcnRoot,
  shadcnBadgeClass,
  shadcnButtonClass,
  shadcnCardClass,
  shadcnInputClass,
} from '../../src/ui/shadcn';

describe('UI/UX Title Case & Lesson Title Formatting', () => {
  it('handles empty, whitespace, parenthesized acronyms, slash compounds, and proper nouns in toTitleCase', () => {
    expect(toTitleCase('')).toBe('');
    expect(toTitleCase('   ')).toBe('');
    expect(toTitleCase('AI & ML ENGINEERING')).toBe('AI & ML Engineering');
    expect(toTitleCase('aws sql and api architecture')).toBe('AWS SQL and API Architecture');
    expect(toTitleCase('COURSEFORGE · DISTRIBUTED SYSTEMS')).toBe('CourseForge · Distributed Systems');
    expect(toTitleCase('Low Level Design (LLD)')).toBe('Low Level Design (LLD)');
    expect(toTitleCase('High Level Design (HLD) & UI/UX')).toBe('High Level Design (HLD) & UI/UX');
    expect(toTitleCase('GenAI, LLMs & RAG Architecture')).toBe('GenAI, LLMs & RAG Architecture');
    expect(toTitleCase('Reinforcement Learning & RLHF')).toBe('Reinforcement Learning & RLHF');
    expect(toTitleCase('CLOUD & DEVOPS')).toBe('Cloud & DevOps');
    expect(toTitleCase('POSTGRESQL, TYPESCRIPT & FASTAPI')).toBe('PostgreSQL, TypeScript & FastAPI');
    expect(toTitleCase('IOS, IPADOS & MACOS')).toBe('iOS, iPadOS & macOS');
  });

  it('strips course prefixes, module tags, and redundant numbering in cleanLessonTitle without corrupting technical terms', () => {
    expect(cleanLessonTitle('')).toBe('Untitled Lesson');
    expect(cleanLessonTitle('   ')).toBe('Untitled Lesson');
    expect(cleanLessonTitle('[Distributed Systems] Module 02 - 04. Consensus & Raft')).toBe('Consensus & Raft');
    expect(cleanLessonTitle('Lecture 12: Zero-Downtime Migrations')).toBe('Zero-Downtime Migrations');
    expect(cleanLessonTitle('01 - Introduction to Go Concurrency')).toBe('Introduction to Go Concurrency');
    expect(cleanLessonTitle('[AI Agents] [Week 3] Building Tool-Use Loops')).toBe('Building Tool-Use Loops');

    // Technical numbers, versions, frequencies, and hyphenated terms must never be stripped
    expect(cleanLessonTitle('802.11ax Wireless Internals')).toBe('802.11ax Wireless Internals');
    expect(cleanLessonTitle('2.4 GHz RF Design')).toBe('2.4 GHz RF Design');
    expect(cleanLessonTitle('10.5Gbps Ethernet Architecture')).toBe('10.5Gbps Ethernet Architecture');
    expect(cleanLessonTitle('2-Phase Commit Protocol')).toBe('2-Phase Commit Protocol');
    expect(cleanLessonTitle('3-Tier Architecture Patterns')).toBe('3-Tier Architecture Patterns');
    expect(cleanLessonTitle('4K Video Streaming Architecture')).toBe('4K Video Streaming Architecture');
  });

  it('formats module badges consistently across edge cases', () => {
    expect(formatModuleBadge(undefined)).toBe('Module 1');
    expect(formatModuleBadge('')).toBe('Module 1');
    expect(formatModuleBadge('MODULE 03: ADVANCED REPLICATION')).toBe('Module 3');
    expect(formatModuleBadge('WEEK 2 - PROMPT ENGINEERING')).toBe('Week 2');
    expect(formatModuleBadge('core architecture')).toBe('Core Architecture');
  });

  it('generates SVG thumbnail data URIs without internal top-left pill overlap and escapes XML entities', () => {
    const uri = createSvgThumbnailDataUri('Systems & <Security> "Masterclass"', 'CLOUD & DEVOPS');
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    const decoded = decodeURIComponent(uri.replace('data:image/svg+xml;utf8,', ''));
    expect(decoded).toContain('Systems &amp; &lt;Security&gt;');
    // Must not render an internal SVG rect pill at x="32" y="32" that collides with HTML .thumb-category-pill
    expect(decoded).not.toContain('x="32" y="32"');
  });
});

describe('shadcn/ui Primitives & Cross-Platform Adaptive Detection', () => {
  it('merges classes safely with cn()', () => {
    expect(cn('btn', undefined, null, false, 'btn-primary', ['active', undefined])).toBe('btn btn-primary active');
    expect(cn()).toBe('');
  });

  it('produces deterministic class strings for shadcn Button, Badge, Card, and Input primitives', () => {
    expect(shadcnButtonClass('default', 'lg')).toContain('cf-shadcn-btn--default');
    expect(shadcnButtonClass('destructive', 'icon')).toContain('cf-shadcn-btn--icon');
    expect(shadcnBadgeClass('terracotta')).toContain('pill-terracotta');
    expect(shadcnCardClass(true)).toContain('cf-shadcn-card--interactive');
    expect(shadcnInputClass('custom-field')).toContain('form-input');
  });

  it('detects platform capabilities and mounts data attributes on root element', () => {
    const caps = detectPlatformCapabilities();
    expect(['ios', 'android', 'macos', 'windows', 'linux', 'web']).toContain(caps.os);
    expect(['compact', 'medium', 'expanded']).toContain(caps.sizeClass);

    const fakeRoot = {
      dataset: {} as Record<string, string>,
      style: { setProperty: () => {} },
    } as unknown as HTMLElement;

    const aborter = new AbortController();
    const applied = mountAdaptiveShadcnRoot(fakeRoot, aborter.signal);
    expect(fakeRoot.dataset.platform).toBe(applied.os);
    expect(fakeRoot.dataset.sizeClass).toBe(applied.sizeClass);
    aborter.abort();
  });
});
