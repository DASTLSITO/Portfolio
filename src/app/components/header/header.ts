import { Component, signal } from '@angular/core';

@Component({
  imports: [],
  selector: 'app-header',
  styleUrl: './header.css',
  templateUrl: './header.html',
})
export class Header {
  openMenu = signal(false);

  /** In-page anchors; each id is set on its section in `main.html`. */
  protected readonly sections = [
    { id: 'about', label: 'About Me' },
    { id: 'stack', label: 'Tech Stack' },
    { id: 'projects', label: 'Projects' },
    { id: 'hackathons', label: 'Hackathons' },
  ];

  toggleMenu() {
    this.openMenu.update(value => !value);
  }

  closeMenu() {
    this.openMenu.set(false);
  }
}
