import { Component } from '@angular/core';
import { Socialmedia } from '../socialmedia/socialmedia';
import { TopographicBackground } from '../topographic-background/topographic-background';

@Component({
  imports: [Socialmedia, TopographicBackground],
  selector: 'app-presentation',
  styleUrl: './presentation.css',
  templateUrl: './presentation.html',
})
export class Presentation {}
