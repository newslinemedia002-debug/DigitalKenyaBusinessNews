import { notFound } from 'next/navigation'
import { siteUrl } from '@/lib/site'
import styles from '@/app/inner.module.css'

export const metadata = {
  title: 'Contact',
  description:
    'Get in touch with the Kenya Business News editorial team.',
  alternates: { canonical: '/contact' },
  openGraph: {
    title: 'Contact - Kenya Business News',
    url: '/contact',
    type: 'website',
    locale: 'en_KE',
  },
}

export default function ContactPage() {
  const sectionLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Kenya Business News',
    url: siteUrl(),
    email: 'mailto:editor@digitalkenyabusinessnews.co.ke',
  }

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl() },
      { '@type': 'ListItem', position: 2, name: 'Contact' },
    ],
  }

  return (
    <div className="container page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(sectionLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />

      <header className={styles.header}>
        <p className={styles.headerKicker}>Contact</p>
        <h1 className={styles.headerTitle}>Get in touch</h1>
      </header>

      <main className="prose">
        <h2>Editorial</h2>
        <p>
          For story tips, corrections, or any editorial inquiry, write to:
        </p>
        <p>
          <a href="mailto:editor@digitalkenyabusinessnews.co.ke">
            editor@digitalkenyabusinessnews.co.ke
          </a>
        </p>

        <h2>Advertising and partnerships</h2>
        <p>
          For advertising rates, sponsored content or partnership proposals, write to:
        </p>
        <p>
          <a href="mailto:sales@digitalkenyabusinessnews.co.ke">sales@digitalkenyabusinessnews.co.ke</a>
        </p>

        <h2>General enquiries</h2>
        <p>
          For everything else, use the same address above and we will direct your
          message to the right desk.
        </p>

        <h2>Postal address</h2>
        <p>
          Kenya Business News<br />
          Taifa Road<br />
          Nairobi, Kenya<br />
          <code>00200</code>
        </p>
      </main>
    </div>
  )
}