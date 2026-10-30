import { useStore } from '@nanostores/react';
import { ClientOnly } from 'remix-utils/client-only';
import { HeaderActionButtons } from './HeaderActionButtons.client';
import { ChatDescription } from '~/lib/persistence/ChatDescription.client';
import { ThemeToggle } from '~/components/ThemeToggle';
import { chatStore } from '~/lib/stores/chat';
import { classNames } from '~/utils/classNames';

export function Header() {
  const chat = useStore(chatStore);

  return (
    <header
      className={classNames('flex items-center px-4 border-b h-[var(--header-height)]', {
        'border-transparent': !chat.started,
        'border-bolt-elements-borderColor': chat.started,
      })}
    >
      <div className="flex items-center gap-2 z-logo text-bolt-elements-textPrimary cursor-pointer">
        <div className="i-ph:sidebar-simple-duotone text-xl" />
        {/*
          The family's wordmark, not upstream's PNG. Two files because the ink and
          the brand differ per mode and an SVG's `<text>` cannot inherit a CSS token;
          `dark:` swaps them, and that variant follows Unity's mode (see
          `app/theme/unity-sync.ts`).
        */}
        <a href="/" className="flex items-center">
          <img src="/ontrak-bolt-light.svg" alt="OnTrak Bolt" className="h-7 w-auto inline-block dark:hidden" />
          <img src="/ontrak-bolt-dark.svg" alt="OnTrak Bolt" className="h-7 w-auto hidden dark:block" />
        </a>
      </div>
      {chat.started && ( // Display ChatDescription and HeaderActionButtons only when the chat has started.
        <>
          <span className="flex-1 px-4 truncate text-center text-bolt-elements-textPrimary">
            <ClientOnly>{() => <ChatDescription />}</ClientOnly>
          </span>
          <ClientOnly>
            {() => (
              <div className="">
                <HeaderActionButtons chatStarted={chat.started} />
              </div>
            )}
          </ClientOnly>
        </>
      )}
      {/*
        The family switch, in the header rather than buried in settings — it is the
        one control that decides how the whole app is painted, and it is the same
        component every other product ships (`app/components/ThemeToggle.tsx`, a
        byte-identical copy from `theme/unity-theme.tsx`).
      */}
      <div className="ml-auto pl-2">
        <ClientOnly>{() => <ThemeToggle />}</ClientOnly>
      </div>
    </header>
  );
}
