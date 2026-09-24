import {
  Body,
  Container,
  Font,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components';
import { createRequire } from 'node:module';
import * as React from 'react';
import { ImmichFooter } from 'src/emails/components/footer.template.js';
import { getFrameleafEmailLogoUrl } from 'src/emails/components/frameleaf-logo.js';

const emailPreset = createRequire(import.meta.url)('tailwindcss-preset-email');

interface FutoLayoutProps {
  children: React.ReactNode;
  preview: string;
  /** Frameleaf server origin that hosts the header logo; without one no hosted logo is rendered. */
  baseUrl?: string;
}

export const FutoLayout = ({ children, preview, baseUrl }: FutoLayoutProps) => (
  <Html>
    <Tailwind
      config={{
        presets: [emailPreset],
        theme: {
          extend: {
            colors: {
              // Light Theme
              'immich-primary': '#4250AF',
              'futo-primary': '#000000',
              'futo-bg': '#F4F4f4',
              'futo-gray': '#F6F6F4',
              'futo-footer': '#6A737D',
            },
            fontFamily: {
              sans: ['Overpass', 'sans-serif'],
              mono: ['Overpass Mono', 'monospace'],
            },
          },
        },
      }}
    >
      <Head>
        <Font
          fontFamily="Overpass"
          fallbackFontFamily="sans-serif"
          webFont={{
            url: 'https://fonts.gstatic.com/s/overpass/v13/qFdH35WCmI96Ajtm81GrU9vyww.woff2',
            format: 'woff2',
          }}
          fontWeight={'100 900'}
          fontStyle="normal"
        />
      </Head>
      <Preview>{preview}</Preview>
      <Body className="bg-futo-bg my-auto mx-auto px-2 font-sans text-base text-futo-primary">
        <Container className="my-[40px] mx-auto max-w-[465px]">
          <Section className="my-6 p-12 border border-red-400 rounded-[50px] bg-gray-50">
            {baseUrl && (
              <Section className="flex justify-center mb-12">
                <Img
                  src={getFrameleafEmailLogoUrl(baseUrl)}
                  className="h-12 antialiased rounded-none"
                  alt="Frameleaf"
                />
              </Section>
            )}

            {children}
          </Section>

          <Section className="flex justify-center my-6">
            <Link href="https://futo.org">
              <Img className="h-6" src="https://futo.org/images/FutoMainLogo.svg" alt="FUTO" />
            </Link>
          </Section>

          <Hr className="my-2 text-futo-gray" />

          <ImmichFooter />
        </Container>
      </Body>
    </Tailwind>
  </Html>
);

FutoLayout.PreviewProps = {
  preview: 'This is the preview shown on some mail clients',
  children: <Text>Email body goes here.</Text>,
} as FutoLayoutProps;

export default FutoLayout;
