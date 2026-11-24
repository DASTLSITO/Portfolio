import { Component } from '@angular/core';
import { Presentation } from '../presentation/presentation';
import { Stack } from '../stack/stack';
import { Projects } from '../projects/projects';
import { Hackathons } from '../hackathons/hackathons';

@Component({
  imports: [Presentation, Stack, Projects, Hackathons],
  selector: 'app-main',
  styleUrl: './main.css',
  templateUrl: './main.html',
})
export class Main {}
