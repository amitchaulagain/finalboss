# Finalboss App Flow 

## 1. Configuration

- [] Configuration page contains the basic form: Name, address, phone, email, upload resume, 
- [] Configuration also contains Jobs Preferance section: Keywords, Job Type (full-time,part time,any), job location (on-site,remote,hybrid,any), minimum salary, max salary, Industry type, Experience level, Exclude company names, Exclude keywords, custom resume for each job checkbox etc.

- [] Configuration has a third section called "General QA": it contains list of questions and possible answers. Answers could be free typed in input boxes or selected option among many like the present form of 'Generic Questions' page. In fact move all the questions and ans from 'Generic Questions' to this section of configuration.

- [] The basic form and jobs preferance section is compulsory to run any bot, but in case of generic questions we'll later determine which are 'required' and will label as such without filling them up user won't be able to run job bots.

- [] Save this configuration in a single json including information extracted from the upload resume. Make sure this original resume data is in a separate section like 'original resume' in the json so that it can be accessed separately when needed.

- [] The json file should be stored in users's data folder (for e.g. in linux inside ~/.local/share/finalboss/ 

## 2. Resume Builder

- [] Resume builder shows different designs/templates for resumes that will be used to generate user's final resume pdf/docx files and will be uploaded to job platforms

- [] All the necessary data should be filled first using user set configuration and if not in the configuration, using user's uploaded resume data i.e. 'original_resume' section in user-config.json file. Preference should be given to the configuration and not the original resume in case of conflicting information. 

- [] Data that are not available should be marked as 'N/A' in red/orange instead of filling dummy placeholder. This is to prevent building the base resume with dummy data that could be later uploaded to job sites.

- [] User can manually edit/change/add data in the resume template and save just like present version of 'Resume builder' that is WYSIWYG.

- [] When user saves the resume, save the first resume as the base resume. This resume will be either uploaded to job sites (default) or an enhanced custom resume will be created for each job (if this is set in the configuration) based on it.

- [] each enhanced resume version will be saved with appropriate names and user can set any one of them as the base resume via the 'Resume Builder' page.

- [] Resume builder page also has a resume enhancement button that user can use manually to enhance the base resume based on a saved job detail (saved from previous sessions. This section will have a selection input button that will select one of the previously saved jobs and an 'enhance' button. The resume is enhanced and displayed under the enhancement section just like present 'Resume Enhancement' page.
