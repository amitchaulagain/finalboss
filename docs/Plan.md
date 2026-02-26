# Finalboss App Flow

## 1. Configuration

- [x] Configuration page contains the basic form: Name, address, phone, email, upload resume.

- [x] Configuration also contains Jobs Preference section: Keywords, Job Type (full-time, part time, any), job location (on-site, remote, hybrid, any), minimum salary, max salary, Industry type, Experience level, Exclude company names, Exclude keywords, custom resume for each job checkbox etc.

- [x] Configuration has a third section called "General QA": it contains list of questions and possible answers. Answers could be free typed in input boxes or selected option among many. All questions and answers from 'Generic Questions' page moved here.

- [x] The basic form and jobs preference section is compulsory to run any bot. Generic questions have required labels — without filling required ones, user won't be able to run job bots.

- [x] Configuration saved as a single JSON file (formData + general_questions) stored in the user's data folder (Linux: ~/.local/share/finalboss/, macOS: ~/Library/Application Support/FinalBoss/, Windows: %APPDATA%/FinalBoss/).

## 2. Resume Builder

- [x] Resume builder shows different template designs for resumes that will be used to generate user's final resume pdf/docx files to be uploaded to job platforms.

- [x] Resume data pre-filled from user configuration on new resume creation.

- [x] Data that are not available are marked as 'N/A' in grey/italic instead of filling dummy placeholders. This prevents building the base resume with dummy data that could be later uploaded to job sites.

- [x] User can manually edit/change/add data in the resume template and save — full WYSIWYG editor. Each heading and content is editable. Sections can be added, removed, or hidden.

- [x] When user saves the resume, the first resume is saved as the base resume. This resume will be either uploaded to job sites (default) or an enhanced custom resume will be created for each job (if set in configuration) based on it.

- [x] Each enhanced resume version is saved with an appropriate name and user can set any one of them as the base resume via the 'My Resumes' page.

- [x] Resume builder page has a resume enhancement section where user can manually enhance the base resume based on a saved job. Includes a job selector dropdown and an Enhance button. The enhanced resume is displayed inline with a fit score and can be saved to My Resumes.


## 3. Seek Bot

- [] Check if the Seek Bot is uploading resumes correctly?. If the user's configuration has 'rewrite resume for each job' option selected, then the bot must enhance the 'base resume' and upload it. If not, it should upload the original resume uploaded by the user. 

- [x] Resume's should be uploaded as a pdf file unless the input box suggests another format like docx.

- [] when starting the bot, it should check if the required resume is available i.e. the resume is uploaded or the base resume has been prepared before starting, otherwise show a message saying to upload or create a base resume.

- [] Is the Seek Bot using the data from the configuration in the cover letter

- [] Is the Seek Bot answering all questions with correct answers?

- [] Is the Seek Bot clicking on 'Continue' button after answering questions?

- [] Is the Seek Bot clicking on the 'Submit Application' button?
