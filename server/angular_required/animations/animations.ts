import { state, style, query, group, animate, trigger, transition } from '@angular/animations';

/**
 * *Fade In Out Animation
 */
export const fadeAnimation = trigger('fadeAnimation', [
  state('void', style({ opacity: 0 })),
  transition('void => *, * => void', [animate(200)]),
]);

/**
 * *Fade In Out Router Animation
 */
export const routerAnimation = trigger('routerAnimation', [
  transition('* <=> *', [
    query(':enter, :leave', style({ opacity: 0, right: '-2%' }), {
      optional: true,
    }),
    group([
      query(
        ':enter',
        [
          style({ opacity: 0, right: '-2%' }),
          animate('0.3s ease-in-out', style({ opacity: 1, right: '0' })),
        ],
        { optional: true },
      ),
      query(
        ':leave',
        [
          style({ opacity: 1, right: '0' }),
          animate('0.3s ease-in-out', style({ opacity: 0, right: '-2%' })),
        ],
        { optional: true },
      ),
    ]),
  ]),
]);

/**
 * *Slide In Out Animation
 */
export const slideInOut = trigger('slideInOut', [
  state('void', style({ height: '0', opacity: 0 })),
  transition('void <=> *', [animate('200ms ease-in-out')]),
]);

/**
 * *Slide In Out Tab Animation
 */
export const slideInOutTab = trigger('slideInOutTab', [
  state('void', style({ height: '0', opacity: 0 })),
  transition('void <=> *', [animate('500ms ease-in-out')]),
]);
